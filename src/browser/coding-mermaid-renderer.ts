import mermaid from "mermaid";

const MERMAID_SELECTOR = [
  ".coding-message-body pre[lang='mermaid'] > code",
  ".coding-message-body pre > code.mermaid",
  ".coding-message-body pre > code.language-mermaid",
  ".coding-message-body pre > code.lang-mermaid",
].join(",");
const MAX_DIAGRAMS_PER_PAGE = 12;
const MAX_DIAGRAM_SOURCE_LENGTH = 40_000;
let diagramSequence = 0;
let renderQueue = Promise.resolve();

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  suppressErrorRendering: true,
  theme: "base",
  flowchart: { htmlLabels: false },
  themeVariables: {
    background: "#11130f",
    primaryColor: "#1e2819",
    primaryTextColor: "#edf3e7",
    primaryBorderColor: "#9bdc6b",
    lineColor: "#9bdc6b",
    secondaryColor: "#18201a",
    tertiaryColor: "#22291f",
    textColor: "#edf3e7",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  },
});

const renderMermaidDiagrams = async (): Promise<void> => {
  const candidates = [...document.querySelectorAll<HTMLElement>(MERMAID_SELECTOR)]
    .filter((code) => !code.closest("[data-coding-mermaid]"))
    .slice(0, MAX_DIAGRAMS_PER_PAGE);
  for (const code of candidates) {
    const pre = code.closest("pre");
    const source = code.textContent?.trim() ?? "";
    if (!(pre instanceof HTMLPreElement) || !source || source.length > MAX_DIAGRAM_SOURCE_LENGTH) continue;
    pre.dataset.mermaidState = "rendering";
    try {
      const id = `roster-mermaid-${++diagramSequence}`;
      const { svg, bindFunctions } = await mermaid.render(id, source);
      const figure = document.createElement("figure");
      figure.className = "coding-mermaid-diagram";
      figure.dataset.codingMermaid = "rendered";
      figure.setAttribute("role", "img");
      figure.setAttribute("aria-label", "Rendered Mermaid diagram");
      const canvas = document.createElement("div");
      canvas.className = "coding-mermaid-canvas";
      canvas.innerHTML = svg;
      const moduleScript = document.querySelector<HTMLScriptElement>(
        "script[data-coding-enhancements]",
      );
      for (const style of canvas.querySelectorAll<HTMLStyleElement>("style")) {
        if (moduleScript?.nonce) style.nonce = moduleScript.nonce;
      }
      const sourceDisclosure = document.createElement("details");
      sourceDisclosure.className = "coding-mermaid-source";
      const summary = document.createElement("summary");
      summary.textContent = "View diagram source";
      const sourcePre = document.createElement("pre");
      const sourceCode = document.createElement("code");
      sourceCode.textContent = source;
      sourcePre.append(sourceCode);
      sourceDisclosure.append(summary, sourcePre);
      figure.append(canvas, sourceDisclosure);
      pre.replaceWith(figure);
      bindFunctions?.(canvas);
    } catch {
      pre.dataset.mermaidState = "error";
      pre.setAttribute("aria-label", "Mermaid source could not be rendered");
    }
  }
};

export const scheduleMermaidRender = (): void => {
  renderQueue = renderQueue.then(renderMermaidDiagrams, renderMermaidDiagrams);
};
