import { createCronHandler } from "@/lib/jobs/handler";
import { registry } from "@/lib/jobs/registry";

// No runtime/dynamic/revalidate exports (Cache Components forbids them); POST is always dynamic.
export const { POST, GET } = createCronHandler(registry);
