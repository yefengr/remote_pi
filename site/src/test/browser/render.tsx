import type { ReactNode } from "react";
import { render } from "vitest-browser-react";
import { PwaUiProvider } from "@/components/pwa/pwa-ui-provider";

export function renderPwa(ui: ReactNode) {
  return render(
    <PwaUiProvider>
      <div className="pwa-root">{ui}</div>
    </PwaUiProvider>,
  );
}
