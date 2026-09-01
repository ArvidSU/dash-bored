import type { ReactNode } from "react";
import type { ComponentRendererProps } from "./types";
import { stringProp } from "./shared";

export default function Text({ props }: ComponentRendererProps): ReactNode {
  const content = stringProp(props, ["content", "text"]);
  const requestedVariant = stringProp(props, ["variant"], "body");
  const variant = ["title", "heading", "body", "muted", "code"].includes(requestedVariant) ? requestedVariant : "body";
  if (variant === "title") return <h1 className="text text--title">{content}</h1>;
  if (variant === "heading") return <h2 className="text text--heading">{content}</h2>;
  if (variant === "code") return <code className="text text--code">{content}</code>;
  return <p className={`text text--${variant}`}>{content}</p>;
}
