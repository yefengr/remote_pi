"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { ActionIcon as MantineActionIcon, type ActionIconProps } from "@mantine/core";

export type IconButtonTone = "default" | "primary" | "danger";

type ProjectIconButtonProps = ActionIconProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ActionIconProps> & {
  tone?: IconButtonTone;
};

const toneDefaults: Record<IconButtonTone, Pick<ActionIconProps, "variant" | "color">> = {
  default: { variant: "subtle" },
  primary: { variant: "filled", color: "remotePi" },
  danger: { variant: "outline", color: "red" },
};

export const IconButton = forwardRef<HTMLButtonElement, ProjectIconButtonProps>(function IconButton(
  { className, tone = "default", variant, color, size = 44, ...props },
  ref,
) {
  const defaults = toneDefaults[tone];
  return (
    <MantineActionIcon
      ref={ref}
      {...props}
      className={className ? `pwa-icon-button ${className}` : "pwa-icon-button"}
      data-tone={tone}
      variant={variant ?? defaults.variant}
      color={color ?? defaults.color}
      size={size}
    />
  );
});
