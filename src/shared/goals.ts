// Plain-English meaning of goals the PaywallProject WordPress plugin sends, so the Goals table explains itself.
// Other sites' own goal names have no entry and show as they are.

export const GOAL_INFO: Record<string, string> = {
  paywall_shown_free: 'Saw the free sign-up wall',
  paywall_shown_paid: 'Saw the paid subscribe wall',
  paywall_shown: 'Saw a paywall (older page, free or paid unknown)',
  paywall_register: 'Clicked sign up on the free wall',
  free_signup_submit: 'Sent the free sign-up form',
  signup: 'Created an account',
  paywall_cta: 'Clicked subscribe on the paid wall',
  paywall_plan_select: 'Picked a plan on the paid wall',
  plan_select: 'Picked a plan on the subscribe page',
  checkout_submit: 'Sent the payment form',
};

export function goalInfo(name: string | null | undefined): string | undefined {
  return name ? GOAL_INFO[name] : undefined;
}
