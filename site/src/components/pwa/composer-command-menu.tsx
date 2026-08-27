"use client";

import { useState } from "react";
import { ArrowLeft, Check, ChevronRight, Cpu, FilePlus2, Gauge, Minimize2 } from "lucide-react";
import type { ThinkingLevel, WireModel } from "@/lib/remote-pi/types";

export type ComposerCommandAction = "session_new" | "session_compact" | "model_set" | "thinking_set";
export type ComposerCommandMenuView = "root" | "models" | "thinking";

export const COMPOSER_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

type ComposerCommandMenuCallbacks = {
  onNewSession: () => void;
  onCompactSession: () => void;
  onSetModel: (model: WireModel) => void;
  onSetThinking: (level: ThinkingLevel) => void;
};

export type ComposerCommandMenuPanelProps = ComposerCommandMenuCallbacks & {
  view: ComposerCommandMenuView;
  isOnline: boolean;
  isWorking: boolean;
  pendingAction: ComposerCommandAction | null;
  models: WireModel[];
  currentModel: WireModel | null;
  currentModelFallback: string | null;
  thinking: ThinkingLevel;
  onBack: () => void;
  onOpenModels: () => void;
  onOpenThinking: () => void;
};

export type ComposerCommandMenuProps = Omit<ComposerCommandMenuPanelProps, "view" | "onBack" | "onOpenModels" | "onOpenThinking">;

function modelLabel(model: WireModel): string {
  return `${model.provider} / ${model.name}`;
}

function isCurrentModel(model: WireModel, currentModel: WireModel | null): boolean {
  return currentModel?.provider === model.provider && currentModel.id === model.id;
}

export function ComposerCommandMenuPanel({
  view,
  isOnline,
  isWorking,
  pendingAction,
  models,
  currentModel,
  currentModelFallback,
  thinking,
  onNewSession,
  onCompactSession,
  onSetModel,
  onSetThinking,
  onBack,
  onOpenModels,
  onOpenThinking,
}: ComposerCommandMenuPanelProps) {
  const actionDisabled = !isOnline || pendingAction !== null;
  const newSessionDisabled = actionDisabled || isWorking;
  const currentModelLabel = currentModel
    ? modelLabel(currentModel)
    : currentModelFallback || "Current model unavailable";

  if (view === "models") {
    return <div className="pwa-command-menu-panel" role="menu" aria-label="Change model">
      <button className="pwa-command-back" type="button" onClick={onBack}><ArrowLeft size={16} /><span>Back</span></button>
      <div className="pwa-command-menu-heading">Change model</div>
      {models.length ? models.map((model) => {
        const selected = isCurrentModel(model, currentModel);
        return <button className="pwa-command-row pwa-command-choice" type="button" role="menuitem" key={`${model.provider}:${model.id}`} disabled={actionDisabled} onClick={() => onSetModel(model)}>
          <Cpu size={16} />
          <span className="pwa-command-copy"><span>{modelLabel(model)}</span><small>{model.id}</small></span>
          {selected ? <Check className="pwa-command-check" size={16} aria-label="Current model" /> : null}
        </button>;
      }) : <p className="pwa-command-empty">No models available.</p>}
    </div>;
  }

  if (view === "thinking") {
    return <div className="pwa-command-menu-panel" role="menu" aria-label="Thinking level">
      <button className="pwa-command-back" type="button" onClick={onBack}><ArrowLeft size={16} /><span>Back</span></button>
      <div className="pwa-command-menu-heading">Thinking level</div>
      {COMPOSER_THINKING_LEVELS.map((level) => {
        const selected = thinking === level;
        return <button className="pwa-command-row pwa-command-choice" type="button" role="menuitem" key={level} disabled={actionDisabled} onClick={() => onSetThinking(level)}>
          <Gauge size={16} />
          <span className="pwa-command-copy"><span>{level}</span></span>
          {selected ? <Check className="pwa-command-check" size={16} aria-label="Current thinking level" /> : null}
        </button>;
      })}
    </div>;
  }

  return <div className="pwa-command-menu-panel" role="menu" aria-label="Pi commands">
    <button className="pwa-command-row" type="button" role="menuitem" disabled={newSessionDisabled} onClick={onNewSession}>
      <FilePlus2 size={16} />
      <span className="pwa-command-copy"><code>/new</code><small>New session</small></span>
    </button>
    <button className="pwa-command-row" type="button" role="menuitem" disabled={newSessionDisabled} onClick={onCompactSession}>
      <Minimize2 size={16} />
      <span className="pwa-command-copy"><code>/compact</code><small>Compact context</small></span>
    </button>
    <button className="pwa-command-row" type="button" role="menuitem" disabled={actionDisabled} onClick={onOpenModels}>
      <Cpu size={16} />
      <span className="pwa-command-copy"><code>/model</code><small>{currentModelLabel}</small></span>
      <ChevronRight className="pwa-command-chevron" size={16} />
    </button>
    <button className="pwa-command-row" type="button" role="menuitem" disabled={actionDisabled} onClick={onOpenThinking}>
      <Gauge size={16} />
      <span className="pwa-command-copy"><code>/thinking</code><small>Thinking level: {thinking}</small></span>
      <ChevronRight className="pwa-command-chevron" size={16} />
    </button>
  </div>;
}

export function ComposerCommandMenu(props: ComposerCommandMenuProps) {
  const [view, setView] = useState<ComposerCommandMenuView>("root");

  return <ComposerCommandMenuPanel
    {...props}
    view={view}
    onBack={() => setView("root")}
    onOpenModels={() => setView("models")}
    onOpenThinking={() => setView("thinking")}
  />;
}
