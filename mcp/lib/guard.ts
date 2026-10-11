import { redirect } from "next/navigation";
import { isAuthed } from "./session";

export async function requireLogin() {
  if (!(await isAuthed())) redirect("/login");
}
