import { Suspense } from "react";
import { AuthCard } from "./auth-card";
import { GoogleButton } from "./google-button";

const ERRORS: Record<string, string> = {
  NOT_INVITED: "This email hasn't been invited. Ask the owner for access.",
  ACCESS_EXPIRED: "Your access has expired. Ask the owner to renew it.",
};

async function SignInError({ searchParams }: { searchParams: PageProps<"/sign-in">["searchParams"] }) {
  const { error } = await searchParams;
  if (typeof error !== "string") return null;
  return (
    <p role="alert" className="text-[13px] text-destructive">
      {ERRORS[error] ?? "Sign-in failed. Try again."}
    </p>
  );
}

export default function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  return (
    <AuthCard title="Sign in to continue">
      <GoogleButton />
      <Suspense fallback={null}>
        <SignInError searchParams={searchParams} />
      </Suspense>
    </AuthCard>
  );
}
