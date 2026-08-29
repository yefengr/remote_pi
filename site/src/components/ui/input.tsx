"use client";

import { forwardRef } from "react";
import { TextInput as MantineTextInput, type TextInputProps } from "@mantine/core";

export const Input = forwardRef<HTMLInputElement, TextInputProps>(function Input(
  { className, size = "md", ...props },
  ref,
) {
  return (
    <MantineTextInput
      ref={ref}
      {...props}
      className={className ? `pwa-input ${className}` : "pwa-input"}
      size={size}
    />
  );
});
