import type { WebviewTagElement } from "electrobun/view";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "electrobun-webview": React.DetailedHTMLProps<
        React.HTMLAttributes<WebviewTagElement>,
        WebviewTagElement
      > & {
        src?: string;
        renderer?: "cef" | "native";
        sandbox?: boolean | string;
      };
    }
  }
}

export {};
