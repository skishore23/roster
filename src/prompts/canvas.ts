import { loadPromptConfig, renderPrompt as renderPromptTemplate } from "./common.js";
import { hashPrompts } from "./hash.js";

export type CanvasPromptConfig = {
  readonly system: {
    readonly artDirector: string;
    readonly artist: string;
    readonly critic: string;
    readonly repair: string;
    readonly controlVote: string;
  };
  readonly user: {
    readonly artDirector: string;
    readonly artist: string;
    readonly critic: string;
    readonly repair: string;
    readonly controlVote: string;
  };
};

export const loadCanvasPrompts = (): CanvasPromptConfig =>
  loadPromptConfig<CanvasPromptConfig>({ name: "canvas", tag: "canvas" });

export const renderCanvasPrompt = (template: string, vars: Record<string, string>): string =>
  renderPromptTemplate(template, vars);

/** Bump whenever schema-coupled runtime prompt addenda change outside the JSON templates. */
export const CANVAS_PROMPT_PROTOCOL_VERSION = "canvas-feature-scaffold-svg-v2";

export const hashCanvasPrompts = (prompts: CanvasPromptConfig): string => hashPrompts({
  prompts,
  runtimeProtocolVersion: CANVAS_PROMPT_PROTOCOL_VERSION,
});
