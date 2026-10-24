// The API is served by this same Next.js app, so requests go to the page's own origin. Set
// NEXT_PUBLIC_API_BASE_URL only to point the site at another deployment's API.
export const API_URL = (process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/+$/, "")
