// Driver for `agda --interaction-json`.
//
// The interaction protocol has no request IDs: responses just stream, and a
// `JSON> ` prompt is emitted when Agda is ready again. We serialise commands
// through a queue and resolve each on its known terminal response kind
// (load -> InteractionPoints, make_case -> MakeCase, ...), with a timeout
// safety net. All ranges Agda reports are line:col, which (see mirror.ts) map
// to the .lagda.scrbl by identity.

import { spawn, ChildProcessWithoutNullStreams } from "child_process";

export interface Goal {
  id: number;
  type: string;
  line: number;      // 1-based, Agda coords (== scrbl coords)
  startCol: number;  // 1-based
  endCol: number;
}

export interface LoadResult {
  goals: Goal[];
  errors: AgdaError[];
  warnings: AgdaError[];
}

export interface AgdaError {
  message: string;
  line?: number;      // 1-based start line
  endLine?: number;
  startCol?: number;
  endCol?: number;
}

// Agda embeds the location in the message text as `:L.C-C:` or `:L.C-L.C:`.
const LOC = /:(\d+)\.(\d+)-(?:(\d+)\.)?(\d+):/;

function parseError(e: any): AgdaError {
  const message: string =
    typeof e === "string" ? e : (e?.message ?? e?.error?.message ?? JSON.stringify(e));
  const m = LOC.exec(message);
  if (m) {
    const line = +m[1];
    return {
      message,
      line,
      startCol: +m[2],
      endLine: m[3] ? +m[3] : line,
      endCol: +m[4],
    };
  }
  return { message };
}

export interface MakeCaseResult {
  clauses: string[];
  variant: string;   // "Function" | "ExtendedLambda"
  line: number;      // 1-based line of the clause to replace
}

export interface GiveResult {
  str: string;       // text to put in place of the hole
  line: number;      // 1-based, the {! !} hole range (== scrbl coords)
  startCol: number;
  endCol: number;
}

export interface GoalInfo {
  id: number;
  type: string;
  context: { name: string; type: string }[];
}

function rangeOf(obj: any): { line?: number; startCol?: number; endCol?: number } {
  const r = obj?.range?.[0];
  return { line: r?.start?.line, startCol: r?.start?.col, endCol: r?.end?.col };
}

// Default ceiling for a single load. Cold-compiling TypeTopology/cubical/stdlib
// can take a while, but waiting forever is worse than telling the user Agda is
// not responding — callers can raise this via the `agda-scrbl.loadTimeout`
// setting. Non-load commands use the shorter COMMAND_TIMEOUT below.
export const DEFAULT_LOAD_TIMEOUT = 120_000;   // 2 minutes
const COMMAND_TIMEOUT = 60_000;

export class Agda {
  private proc: ChildProcessWithoutNullStreams;
  private buf = "";
  private queue: Array<() => void> = [];
  private busy = false;
  private sink: ((resp: any) => void) | null = null;
  // The reject handler of the command currently awaiting a response, so a
  // process death or stdin failure can fail it immediately instead of letting
  // it hang until the timeout.
  private inflightReject: ((e: Error) => void) | null = null;
  private disposing = false;

  // Set once the process has died (crash, exit, or dispose). Every queued or new
  // command rejects immediately rather than writing to a dead stdin and waiting.
  dead = false;
  deadReason = "";

  goals: Goal[] = [];
  errors: AgdaError[] = [];
  warnings: AgdaError[] = [];

  constructor(
    private mirrorFile: string,
    cwd: string,
    agdaPath = "agda",
    private onLog?: (s: string) => void,
    // Called when the process dies unexpectedly (not on an explicit dispose), so
    // the host can flip its status to error with the reason.
    private onFatal?: (reason: string) => void,
  ) {
    this.proc = spawn(agdaPath, ["--interaction-json"], { cwd });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => this.onData(d));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (d: string) => this.onLog?.(String(d)));
    // spawn failure (e.g. agda not on PATH) surfaces here, not via exit.
    this.proc.on("error", (err) => this.die(`agda failed to start: ${err.message}`, true));
    // Writing to a process that has gone away emits EPIPE on stdin; swallow it
    // through die() rather than letting it crash the host as an unhandled error.
    this.proc.stdin.on("error", (err) => this.die(`agda stdin error: ${err.message}`, !this.disposing));
    this.proc.on("exit", (code, signal) => {
      this.onLog?.(`agda exited: ${signal ? `signal ${signal}` : `code ${code}`}\n`);
      this.die(
        signal ? `agda was killed (${signal})` : `agda exited (code ${code})`,
        !this.disposing,
      );
    });
  }

  // Mark the process dead, fail any in-flight command, and (when the death was
  // unexpected) notify the host. Idempotent — the first cause wins.
  private die(reason: string, fatal: boolean) {
    if (this.dead) return;
    this.dead = true;
    this.deadReason = reason;
    this.inflightReject?.(new Error(reason));
    if (fatal) this.onFatal?.(reason);
  }

  private onData(d: string) {
    this.buf += d;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      while (line.startsWith("JSON> ")) line = line.slice(6);
      line = line.trim();
      if (!line) continue;
      let resp: any;
      try { resp = JSON.parse(line); } catch { continue; }
      this.dispatch(resp);
    }
  }

  private dispatch(resp: any) {
    if (resp.kind === "DisplayInfo" && resp.info?.kind === "AllGoalsWarnings") {
      const info = resp.info;
      this.goals = (info.visibleGoals ?? [])
        .map((g: any): Goal => {
          const r = rangeOf(g.constraintObj);
          return {
            id: g.constraintObj?.id,
            type: g.type,
            line: r.line!, startCol: r.startCol!, endCol: r.endCol!,
          };
        })
        .filter((g: Goal) => g.id !== undefined);
      this.errors = (info.errors ?? []).map(parseError);
      this.warnings = (info.warnings ?? []).map(parseError);
    } else if (resp.kind === "DisplayInfo" && resp.info?.kind === "Error") {
      this.errors = [parseError(resp.info.error ?? resp.info)];
    }
    if (this.sink) this.sink(resp);
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () =>
        job().then(resolve, reject).finally(() => {
          const next = this.queue.shift();
          if (next) next();
          else this.busy = false;
        });
      if (this.busy) this.queue.push(run);
      else { this.busy = true; run(); }
    });
  }

  private command(
    body: string,
    isTerminal: (r: any) => boolean,
    mode = "None Direct",
    timeoutMs = COMMAND_TIMEOUT,
  ): Promise<any[]> {
    return this.enqueue(
      () =>
        new Promise<any[]>((resolve, reject) => {
          if (this.dead) { reject(new Error(this.deadReason || "agda is not running")); return; }
          const collected: any[] = [];
          let settled = false;
          const cleanup = () => { this.sink = null; this.inflightReject = null; clearTimeout(t); };
          const done = () => { if (settled) return; settled = true; cleanup(); resolve(collected); };
          const fail = (e: Error) => { if (settled) return; settled = true; cleanup(); reject(e); };
          const t = setTimeout(
            () => fail(new Error(`Agda did not respond within ${Math.round(timeoutMs / 1000)}s`)),
            timeoutMs,
          );
          this.inflightReject = fail;
          this.sink = (r) => { collected.push(r); if (isTerminal(r)) done(); };
          try {
            this.proc.stdin.write(`IOTCM "${this.mirrorFile}" ${mode} (${body})\n`);
          } catch (e) {
            fail(new Error(`failed to send command to agda: ${String(e)}`));
          }
        }),
    );
  }

  async load(timeoutMs = DEFAULT_LOAD_TIMEOUT): Promise<LoadResult> {
    this.goals = []; this.errors = []; this.warnings = [];
    await this.command(
      `Cmd_load "${this.mirrorFile}" []`,
      (r) => r.kind === "InteractionPoints" ||
             (r.kind === "DisplayInfo" && r.info?.kind === "Error"),
      "None Direct",
      timeoutMs,
    );
    return { goals: this.goals, errors: this.errors, warnings: this.warnings };
  }

  async makeCase(id: number, variable: string): Promise<MakeCaseResult | null> {
    const resps = await this.command(
      `Cmd_make_case ${id} noRange "${variable}"`,
      (r) => r.kind === "MakeCase",
      "NonInteractive Direct",
    );
    const mc = resps.find((r) => r.kind === "MakeCase");
    if (!mc) return null;
    return { clauses: mc.clauses, variant: mc.variant, line: rangeOf(mc.interactionPoint).line! };
  }

  /** Fill a {! term !} hole with `content`; returns the result + hole range. */
  async give(id: number, content: string): Promise<GiveResult | null> {
    return this.giveLike(`Cmd_give WithoutForce ${id} noRange ${JSON.stringify(content)}`, content);
  }

  /** Refine a {! term !} hole (may leave new holes); returns result + hole range. */
  async refine(id: number, content: string): Promise<GiveResult | null> {
    return this.giveLike(`Cmd_refine ${id} noRange ${JSON.stringify(content)}`, content);
  }

  private async giveLike(body: string, content: string): Promise<GiveResult | null> {
    const resps = await this.command(body, (r) => r.kind === "GiveAction", "NonInteractive Direct");
    const ga = resps.find((r) => r.kind === "GiveAction");
    if (!ga) return null;
    const r = rangeOf(ga.interactionPoint);
    return {
      str: ga.giveResult?.str ?? content,
      line: r.line!, startCol: r.startCol!, endCol: r.endCol!,
    };
  }

  /** Goal type + context, structured for display. */
  async goalTypeContext(id: number): Promise<GoalInfo | null> {
    const resps = await this.command(
      `Cmd_goal_type_context Simplified ${id} noRange ""`,
      (r) => r.kind === "DisplayInfo" && r.info?.kind === "GoalSpecific",
      "NonInteractive Direct",
    );
    const di = resps.find((r) => r.kind === "DisplayInfo" && r.info?.kind === "GoalSpecific");
    const gi = di?.info?.goalInfo;
    if (!gi) return null;
    return {
      id,
      type: gi.type,
      context: (gi.entries ?? []).map((e: any) => ({
        name: e.reifiedName ?? e.originalName, type: e.binding,
      })),
    };
  }

  dispose() {
    this.disposing = true;
    // Unstick anything still awaiting a response before we tear the process down.
    this.die("agda session disposed", false);
    try { this.proc.stdin.end(); this.proc.kill(); } catch { /* ignore */ }
  }
}
