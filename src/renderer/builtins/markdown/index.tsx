import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import "./markdown.css";
import type { ComponentRendererProps } from "../types";
import { stringProp } from "../shared";
import { safeMarkdownUrl } from "../../safe-url";

export default function Markdown({ props }: ComponentRendererProps): ReactNode {
  const content = stringProp(props, ["content", "markdown"]);

  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        urlTransform={safeMarkdownUrl}
        components={{
          a: ({ children, href }) => (
            <a href={href} rel="noreferrer" target="_blank">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="markdown__image-placeholder">
              {alt ? `[Image: ${alt}]` : "[Image]"}
            </span>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
