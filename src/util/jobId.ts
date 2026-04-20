import { v7 as uuidv7 } from "uuid";

export function newJobId(): string {
  return uuidv7();
}
