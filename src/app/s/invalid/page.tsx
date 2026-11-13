import Link from "next/link";
import { AuthCard } from "../../sign-in/auth-card";

export default function InvalidShareLinkPage() {
  return (
    <AuthCard title="Link unavailable">
      <p className="text-[13px] text-muted-foreground">It expired or was revoked. Ask whoever shared it for a new one.</p>
      <Link href="/sign-in" className="w-fit text-[13px] font-medium underline-offset-4 hover:underline">
        Sign in instead
      </Link>
    </AuthCard>
  );
}
