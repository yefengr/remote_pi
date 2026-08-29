"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Button as MantineButton, type ButtonProps } from "@mantine/core";

export type ButtonTone = "primary" | "secondary" | "danger" | "text";

type ProjectButtonProps = ButtonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonProps> & {
  tone?: ButtonTone;
};

const toneDefaults: Record<ButtonTone, Pick<ButtonProps, "variant" | "color">> = {
  primary: { variant: "filled", color: "remotePi" },
  secondary: { variant: "default" },
  danger: { variant: "outline", color: "red" },
  text: { variant: "transparent", color: "remotePi" },
};

export const Button = forwardRef<HTMLButtonElement, ProjectButtonProps>(function Button(
  { className, tone = "primary", variant, color, size = "md", ...props },
  ref,
) {
  const defaults = toneDefaults[tone];
  return (
    <MantineButton
      ref={ref}
      {...props}
      className={className ? `pwa-button ${className}` : "pwa-button"}
      data-tone={tone}
      variant={variant ?? defaults.variant}
      color={color ?? defaults.color}
      size={size}
    />
  );
});
