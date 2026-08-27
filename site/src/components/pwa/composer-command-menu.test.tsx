import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WireModel } from "@/lib/remote-pi/types";
import { ComposerCommandMenuPanel, type ComposerCommandMenuPanelProps } from "./composer-command-menu";

const model: WireModel = {
  id: "claude-sonnet-4",
  name: "Claude Sonnet 4",
  provider: "anthropic",
  reasoning: true,
  context_window: 200000,
  vision: true,
};

const panelProps: Omit<ComposerCommandMenuPanelProps, "view"> = {
  isOnline: true,
  isWorking: false,
  pendingAction: null,
  models: [model],
  currentModel: model,
  currentModelFallback: null,
  thinking: "medium",
  onNewSession: () => {},
  onCompactSession: () => {},
  onSetModel: () => {},
  onSetThinking: () => {},
  onBack: () => {},
  onOpenModels: () => {},
  onOpenThinking: () => {},
};

function renderPanel(view: ComposerCommandMenuPanelProps["view"], overrides: Partial<ComposerCommandMenuPanelProps> = {}): string {
  return renderToStaticMarkup(<ComposerCommandMenuPanel {...panelProps} {...overrides} view={view} />);
}

test("renders all root Pi commands", () => {
  const html = renderPanel("root");

  assert.match(html, /\/new/);
  assert.match(html, /New session/);
  assert.match(html, /\/compact/);
  assert.match(html, /Compact context/);
  assert.match(html, /\/model/);
  assert.match(html, /anthropic \/ Claude Sonnet 4/);
  assert.match(html, /\/thinking/);
  assert.match(html, /Thinking level: medium/);
});

test("falls back to room metadata before the current model catalog arrives", () => {
  const html = renderPanel("root", { currentModel: null, currentModelFallback: "GPT-5.4" });

  assert.match(html, /GPT-5.4/);
  assert.doesNotMatch(html, /Current model unavailable/);
});

test("shows an explicit unavailable state when no current model is known", () => {
  const html = renderPanel("root", { currentModel: null, currentModelFallback: null });

  assert.match(html, /Current model unavailable/);
});

test("disables new and compact while the active room is working", () => {
  const html = renderPanel("root", { isWorking: true });

  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
});

test("disables every command while offline", () => {
  const html = renderPanel("root", { isOnline: false });

  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
});

test("disables every command while another action is pending", () => {
  const html = renderPanel("root", { pendingAction: "model_set" });

  assert.equal((html.match(/disabled=""/g) ?? []).length, 4);
});

test("renders the model chooser with provider, name, and current model", () => {
  const html = renderPanel("models");

  assert.match(html, /Back/);
  assert.match(html, /Change model/);
  assert.match(html, /anthropic \/ Claude Sonnet 4/);
  assert.match(html, /aria-label="Current model"/);
});

test("renders every thinking level and marks the active level", () => {
  const html = renderPanel("thinking");

  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh"]) assert.match(html, new RegExp(`>${level}<`));
  assert.match(html, /aria-label="Current thinking level"/);
});
