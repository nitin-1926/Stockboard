"use client";

import { LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";

export function SignOutButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      title="Sign out"
      className="min-h-12 justify-start gap-3 px-3 text-muted-foreground lg:min-h-8 lg:w-8 lg:justify-center lg:px-0"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await authClient.signOut();
          router.replace("/sign-in");
        })
      }
    >
      <LogOutIcon aria-hidden strokeWidth={1.75} />
      <span className="lg:sr-only">{pending ? "Signing out" : "Sign out"}</span>
    </Button>
  );
}
