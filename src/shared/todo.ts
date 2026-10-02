export interface TodoItem {
  id: string;
  description: string;
  done: boolean;
  tags: string[];
}

export function createTodoId(): string {
  return `todo-${crypto.randomUUID()}`;
}
