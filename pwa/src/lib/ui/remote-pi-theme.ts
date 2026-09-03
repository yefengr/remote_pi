import { createTheme } from "@mantine/core";

/** Mantine 仅负责 PWA 基础组件行为，视觉参数映射到 Remote Pi 现有设计 token。 */
export const remotePiTheme = createTheme({
  primaryColor: "remotePi",
  primaryShade: { light: 6, dark: 5 },
  colors: {
    remotePi: [
      "#dff6ff",
      "#b9eaff",
      "#8bdcff",
      "#67d1fa",
      "#4fc3f7",
      "#2db5ef",
      "#159bd6",
      "#0b7fad",
      "#076586",
      "#044b63",
    ],
  },
  fontFamily: "var(--ff-body)",
  fontFamilyMonospace: "var(--ff-mono)",
  headings: { fontFamily: "var(--ff-display)", fontWeight: "600" },
  defaultRadius: "sm",
  radius: {
    xs: "5px",
    sm: "8px",
    md: "10px",
    lg: "13px",
    xl: "18px",
  },
  respectReducedMotion: true,
  cursorType: "pointer",
  components: {
    Button: { defaultProps: { size: "md" } },
    ActionIcon: { defaultProps: { size: "lg", variant: "subtle" } },
    TextInput: { defaultProps: { size: "md" } },
    Textarea: { defaultProps: { size: "md" } },
    Select: { defaultProps: { size: "md" } },
    Badge: { defaultProps: { size: "xs", variant: "light", radius: "sm" } },
  },
});
