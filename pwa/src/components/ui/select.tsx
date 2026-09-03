"use client";

import { Select as MantineSelect, type Primitive, type SelectProps } from "@mantine/core";

export function Select<Value extends Primitive = string>({ className, size = "md", ...props }: SelectProps<Value>) {
  return (
    <MantineSelect
      {...props}
      className={className ? `pwa-select ${className}` : "pwa-select"}
      size={size}
    />
  );
}
