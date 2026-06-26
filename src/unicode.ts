// Curated subset of the agda input table: \abbrev -> symbol.
// Used for inline completion (type \to → →) and the top "Insert symbol" picker.
// Extend freely.
export const UNICODE: [string, string][] = [
  // arrows
  ["to", "→"], ["r", "→"], ["rightarrow", "→"], ["l", "←"], ["leftarrow", "←"],
  ["mapsto", "↦"], ["iff", "⇔"], ["Rightarrow", "⇒"], ["Leftarrow", "⇐"],
  ["leftrightarrow", "↔"], ["hookrightarrow", "↪"], ["uparrow", "↑"], ["downarrow", "↓"],
  // greek lower
  ["alpha", "α"], ["beta", "β"], ["gamma", "γ"], ["delta", "δ"], ["epsilon", "ε"],
  ["zeta", "ζ"], ["eta", "η"], ["theta", "θ"], ["iota", "ι"], ["kappa", "κ"],
  ["lambda", "λ"], ["Gl", "λ"], ["mu", "μ"], ["nu", "ν"], ["xi", "ξ"], ["pi", "π"],
  ["rho", "ρ"], ["sigma", "σ"], ["tau", "τ"], ["phi", "φ"], ["chi", "χ"], ["psi", "ψ"], ["omega", "ω"],
  // greek upper
  ["Gamma", "Γ"], ["Delta", "Δ"], ["Theta", "Θ"], ["Lambda", "Λ"], ["Xi", "Ξ"],
  ["Pi", "Π"], ["Sigma", "Σ"], ["Phi", "Φ"], ["Psi", "Ψ"], ["Omega", "Ω"],
  // blackboard
  ["bN", "ℕ"], ["bZ", "ℤ"], ["bQ", "ℚ"], ["bR", "ℝ"], ["bC", "ℂ"], ["bP", "ℙ"], ["bB", "𝔹"],
  // logic & relations
  ["all", "∀"], ["forall", "∀"], ["ex", "∃"], ["exists", "∃"], ["neg", "¬"],
  ["and", "∧"], ["wedge", "∧"], ["or", "∨"], ["vee", "∨"],
  ["le", "≤"], ["<=", "≤"], ["ge", "≥"], [">=", "≥"], ["ne", "≠"], ["neq", "≠"],
  ["equiv", "≡"], ["==", "≡"], ["cong", "≅"], ["sim", "∼"], ["approx", "≈"],
  ["in", "∈"], ["notin", "∉"], ["subseteq", "⊆"], ["subset", "⊂"], ["supseteq", "⊇"],
  // operators
  ["times", "×"], ["x", "×"], ["o", "∘"], ["circ", "∘"], ["compose", "∘"],
  ["cdot", "·"], ["bullet", "•"], ["sum", "∑"], ["prod", "∏"],
  ["top", "⊤"], ["bot", "⊥"], ["vdash", "⊢"], ["models", "⊨"],
  ["emptyset", "∅"], ["infty", "∞"], ["partial", "∂"], ["nabla", "∇"],
  ["pm", "±"], ["mp", "∓"], ["cup", "∪"], ["cap", "∩"], ["sqcup", "⊔"], ["sqcap", "⊓"],
  ["uplus", "⊎"], ["oplus", "⊕"], ["otimes", "⊗"], ["ldots", "…"], ["cdots", "⋯"],
  // subscripts
  ["_0", "₀"], ["_1", "₁"], ["_2", "₂"], ["_3", "₃"], ["_4", "₄"], ["_5", "₅"],
  ["_6", "₆"], ["_7", "₇"], ["_8", "₈"], ["_9", "₉"], ["_+", "₊"], ["_-", "₋"],
  ["_a", "ₐ"], ["_i", "ᵢ"], ["_n", "ₙ"], ["_e", "ₑ"], ["_o", "ₒ"], ["_x", "ₓ"],
  // superscripts
  ["^0", "⁰"], ["^1", "¹"], ["^2", "²"], ["^3", "³"], ["^4", "⁴"], ["^5", "⁵"],
  ["^6", "⁶"], ["^7", "⁷"], ["^8", "⁸"], ["^9", "⁹"], ["^-", "⁻"], ["^+", "⁺"],
  ["^n", "ⁿ"], ["^i", "ⁱ"],
  // agda / TypeTopology universes
  ["McU", "𝓤"], ["McV", "𝓥"], ["McW", "𝓦"], ["McT", "𝓣"], ["McO", "𝓞"],
];
