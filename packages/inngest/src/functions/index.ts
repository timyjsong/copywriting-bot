export { onboardingPipeline } from "./onboarding.js";
export { roastSubmitted } from "./roast.js";
export { checkoutCompleted } from "./checkout.js";
export { performanceDailyPull } from "./performance.js";

import { onboardingPipeline } from "./onboarding.js";
import { roastSubmitted } from "./roast.js";
import { checkoutCompleted } from "./checkout.js";
import { performanceDailyPull } from "./performance.js";

export const allFunctions = [
  onboardingPipeline,
  roastSubmitted,
  checkoutCompleted,
  performanceDailyPull,
] as const;
