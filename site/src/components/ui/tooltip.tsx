"use client";

import { Tooltip as MantineTooltip, type TooltipProps } from "@mantine/core";

export function Tooltip({ className, ...props }: TooltipProps) {
  return <MantineTooltip {...props} className={className ? `pwa-tooltip ${className}` : "pwa-tooltip"} />;
}
