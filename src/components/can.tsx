import type { ReactNode } from "react";
import { type Action, can, getActor, type OwnedResource } from "@/lib/auth/access";

/**
 * Renders children only if the current actor may perform `action` (adopted fix: controls
 * an actor can't use are not rendered at all). UI convenience only: the server action
 * behind the control still calls authorize(). Wrap in <Suspense> (it reads the request).
 */
export async function Can({
  action,
  resource,
  children,
}: {
  action: Action;
  resource?: OwnedResource;
  children: ReactNode;
}) {
  const actor = await getActor();
  if ("denied" in actor || !can(actor, action, resource)) return null;
  return children;
}
