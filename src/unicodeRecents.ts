// Most-recently-used symbol names, persisted in the extension's globalState so
// the picker can float recent picks to the top. Modelled on vscode-violet.
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

const KEY = "agda-scrbl.unicodeInput.recents";
const CAP = 10;

export class Recents {
  private cache: string[];

  constructor(private memento: MementoLike) {
    const raw = memento.get<unknown>(KEY);
    this.cache =
      Array.isArray(raw) && raw.every((x) => typeof x === "string")
        ? (raw as string[]).slice(0, CAP)
        : [];
  }

  list(): string[] {
    return this.cache.slice();
  }

  async push(name: string): Promise<void> {
    const next = [name, ...this.cache.filter((n) => n !== name)].slice(0, CAP);
    this.cache = next;
    await this.memento.update(KEY, next);
  }
}

// Reorder `all` so entries whose name is recent (in MRU order) lead, with the
// rest keeping their original order. Returns the reordered list and the count of
// leading recent entries (for drawing a separator). Duplicate names are
// preserved — the bundled table has many (e.g. \T -> ◁ and ▷) — so this must not
// key the list by name.
export function orderByRecents<T extends { name: string }>(
  all: T[],
  recents: string[]
): { ordered: T[]; recentCount: number } {
  const rank = new Map(recents.map((n, i) => [n, i]));
  const head: T[] = [];
  const tail: T[] = [];
  for (const s of all) (rank.has(s.name) ? head : tail).push(s);
  head.sort((a, b) => rank.get(a.name)! - rank.get(b.name)!);
  return { ordered: [...head, ...tail], recentCount: head.length };
}
