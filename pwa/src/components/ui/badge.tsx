"use client";

import { Badge as MantineBadge, type BadgeProps } from "@mantine/core";

export type BadgeTone = "default" | "online" | "partial" | "offline" | "checking" | "current";

type ProjectBadgeProps = BadgeProps & {
  tone?: BadgeTone;
};

export function Badge({ className, tone = "default", size = "xs", variant = "light", radius = "sm", ...props }: ProjectBadgeProps) {
  return (
    <MantineBadge
      {...props}
      className={className ? `pwa-badge ${className}` : "pwa-badge"}
      data-tone={tone}
      size={size}
      variant={variant}
      radius={radius}
    />
  );
}
