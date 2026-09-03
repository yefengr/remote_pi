"use client";

import { forwardRef } from "react";
import { Textarea as MantineTextarea, type TextareaProps } from "@mantine/core";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, size = "md", ...props },
  ref,
) {
  return (
    <MantineTextarea
      ref={ref}
      {...props}
      className={className ? `pwa-textarea ${className}` : "pwa-textarea"}
      size={size}
    />
  );
});
