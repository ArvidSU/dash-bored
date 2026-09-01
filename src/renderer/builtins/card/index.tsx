import type { ReactNode } from "react";
import "./card.css";
import type { ComponentRendererProps } from "../types";
import { childSurface, stringProp } from "../shared";

export default function Card({ props, children }: ComponentRendererProps): ReactNode {
  const title = stringProp(props, ["title"]);
  const description = stringProp(props, ["description"]);
  return (
    <section className="card">
      {title || description ? (
        <header className="card__header">
          {title ? <h2>{title}</h2> : null}
          {description ? <p>{description}</p> : null}
        </header>
      ) : null}
      <div className="card__body">{childSurface(children)}</div>
    </section>
  );
}
