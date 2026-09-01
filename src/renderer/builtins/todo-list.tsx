import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { LocalComponentHost } from "../../shared/contracts";
import {
  filterTodos,
  sortTodos,
  todoItemsFromProps,
  todoTags,
} from "../todo";
import type { TodoItem } from "../todo";

interface TodoListProps {
  props: Record<string, unknown>;
  host: LocalComponentHost;
}

type EditField = "description" | "tags";

interface EditTarget {
  index: number;
  field: EditField;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tagsFromInput(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

export function TodoList({ props, host }: TodoListProps): ReactNode {
  const configuredItems = todoItemsFromProps(props.todos);
  const configuredItemsKey = JSON.stringify(configuredItems);
  const [items, setItems] = useState<TodoItem[]>(configuredItems);
  const [filterTag, setFilterTag] = useState("");
  const [description, setDescription] = useState("");
  const [newTags, setNewTags] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editValue, setEditValue] = useState("");
  const editActionRef = useRef<"idle" | "committing" | "cancelled">("idle");

  useEffect(() => {
    if (!saving) setItems(configuredItems);
  }, [configuredItemsKey, saving]);

  const persist = useCallback(async (nextItems: TodoItem[]): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setItems(nextItems);
    try {
      await host.dashboard.updateProps({ ...props, todos: nextItems });
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [host.dashboard, props]);

  const addTodo = async (): Promise<void> => {
    const nextDescription = description.trim();
    if (nextDescription === "") {
      setFormError("Add a description first.");
      return;
    }
    setFormError(null);
    const added: TodoItem = {
      description: nextDescription,
      done: false,
      tags: tagsFromInput(newTags),
    };
    if (await persist([...items, added])) {
      setDescription("");
      setNewTags("");
    }
  };

  const toggleTodo = (item: TodoItem): void => {
    const index = items.indexOf(item);
    if (index < 0) return;
    const nextItems = items.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...candidate, done: !candidate.done } : candidate,
    );
    void persist(nextItems);
  };

  const removeTodo = (item: TodoItem): void => {
    const index = items.indexOf(item);
    if (index < 0) return;
    void persist(items.filter((_, candidateIndex) => candidateIndex !== index));
  };

  const canWrite = !saving;

  const beginEdit = (index: number, field: EditField): void => {
    if (!canWrite) return;
    const item = items[index];
    if (!item) return;
    editActionRef.current = "idle";
    setFormError(null);
    setEditTarget({ index, field });
    setEditValue(field === "description" ? item.description : item.tags.join(", "));
  };

  const cancelEdit = (): void => {
    if (editActionRef.current === "committing") return;
    editActionRef.current = "cancelled";
    setEditTarget(null);
    setEditValue("");
  };

  const commitEdit = (): void => {
    if (editActionRef.current !== "idle" || editTarget === null || saving) return;
    const item = items[editTarget.index];
    if (!item) {
      cancelEdit();
      return;
    }
    const value = editValue.trim();
    if (editTarget.field === "description" && value === "") {
      setFormError("A todo description cannot be empty.");
      return;
    }

    const nextItems = items.map((candidate, index) => {
      if (index !== editTarget.index) return candidate;
      return editTarget.field === "description"
        ? { ...candidate, description: value }
        : { ...candidate, tags: tagsFromInput(value) };
    });
    editActionRef.current = "committing";
    setFormError(null);
    void persist(nextItems).then((success) => {
      if (success) {
        setEditTarget(null);
        setEditValue("");
      }
      editActionRef.current = "idle";
    });
  };

  const tags = todoTags(items);
  useEffect(() => {
    if (filterTag !== "" && !tags.includes(filterTag)) setFilterTag("");
  }, [filterTag, items]);

  const visibleItems = sortTodos(filterTodos(items, filterTag));
  const openCount = items.filter((item) => !item.done).length;

  return (
    <section className="todo" aria-label="YAML todo list">
      <header className="todo__header">
        <div>
          <strong>Todo list</strong>
          <span>{openCount} open · {items.length} total</span>
        </div>
        <label className="todo__filter">
          <span>Tag</span>
          <select value={filterTag} onChange={(event) => setFilterTag(event.target.value)}>
            <option value="">All tags</option>
            {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
        </label>
      </header>

      {error ? (
        <div className="todo__error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      {!error ? (
        visibleItems.length ? (
          <div className="todo__list" role="list" aria-label="Todos">
            {visibleItems.map((item) => {
              const itemIndex = items.indexOf(item);
              const editingDescription = editTarget?.index === itemIndex && editTarget.field === "description";
              const editingTags = editTarget?.index === itemIndex && editTarget.field === "tags";
              return (
                <article className={`todo__item${item.done ? " todo__item--done" : ""}`} key={itemIndex} role="listitem">
                  <div className="todo__item-main">
                    <input
                      type="checkbox"
                      checked={item.done}
                      disabled={!canWrite}
                      aria-label={`${item.done ? "Mark incomplete" : "Mark complete"}: ${item.description}`}
                      onChange={() => toggleTodo(item)}
                    />
                    {editingDescription ? (
                      <input
                        className="todo__edit-input todo__edit-input--description"
                        autoFocus
                        value={editValue}
                        disabled={saving}
                        aria-label="Edit todo description"
                        onChange={(event) => setEditValue(event.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelEdit();
                          }
                        }}
                      />
                    ) : (
                      <button
                        className="todo__description-edit"
                        type="button"
                        disabled={!canWrite}
                        aria-label={`Edit description: ${item.description}`}
                        onClick={() => beginEdit(itemIndex, "description")}
                      >
                        <span className="todo__description">{item.description}</span>
                      </button>
                    )}
                  </div>
                  <div className="todo__item-side">
                    {editingTags ? (
                      <input
                        className="todo__edit-input todo__edit-input--tags"
                        autoFocus
                        value={editValue}
                        disabled={saving}
                        aria-label="Edit todo tags"
                        placeholder="docs, release"
                        onChange={(event) => setEditValue(event.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelEdit();
                          }
                        }}
                      />
                    ) : (
                      <button
                        className="todo__tags-edit"
                        type="button"
                        disabled={!canWrite}
                        aria-label={`Edit tags: ${item.description}`}
                        onClick={() => beginEdit(itemIndex, "tags")}
                      >
                        {item.tags.length ? (
                          <span className="todo__tags" aria-label="Tags">
                            {item.tags.map((tag) => <span key={tag}>{tag}</span>)}
                          </span>
                        ) : <span className="todo__tags-empty">Add tags</span>}
                      </button>
                    )}
                    <button
                      className="todo__remove"
                      type="button"
                      disabled={!canWrite}
                      aria-label={`Remove todo: ${item.description}`}
                      onClick={() => removeTodo(item)}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : items.length ? (
          <p className="todo__message">No todos match the “{filterTag}” tag.</p>
        ) : (
          <p className="todo__message">No todos yet. Add one below.</p>
        )
      ) : null}

      <form
        className="todo__form"
        onSubmit={(event) => {
          event.preventDefault();
          void addTodo();
        }}
      >
        <label>
          <span>Description</span>
          <input
            value={description}
            disabled={!canWrite}
            placeholder="What needs doing?"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          <span>Tags</span>
          <input
            value={newTags}
            disabled={!canWrite}
            placeholder="docs, release"
            onChange={(event) => setNewTags(event.target.value)}
          />
        </label>
        <button type="submit" disabled={!canWrite}>Add item</button>
        {formError ? <span className="todo__form-error" role="alert">{formError}</span> : null}
      </form>
    </section>
  );
}
