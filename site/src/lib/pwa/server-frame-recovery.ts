import type { ServerFrame } from "../remote-pi/protocol-v2/frames";

export type ServerFrameRecoveryAction = "rehello" | "reconnect" | "disconnect" | "ignore";

export type ServerFrameRecoveryEffects = {
  invalidateScope: () => void;
  rehello: () => void;
  reconnect: () => void;
  disconnect: () => void;
};

export function getServerFrameRecoveryAction(frame: ServerFrame): ServerFrameRecoveryAction {
  if (frame.type === "reset") return "rehello";
  if (frame.type !== "bye") return "ignore";
  if (frame.reason === "session_replaced") return "reconnect";
  return "disconnect";
}

/** Applies exactly one recovery path for a frame; transport/UI effects are injected by the caller. */
export function recoverServerFrame(frame: ServerFrame, effects: ServerFrameRecoveryEffects): ServerFrameRecoveryAction {
  const action = getServerFrameRecoveryAction(frame);
  if (action === "ignore") return action;
  effects.invalidateScope();
  effects[action]();
  return action;
}
