// Demo sample images live in /public/samples. Resolve against Vite's base so
// they load both at the web root and inside the Anna bundle path.
export const SAMPLES = `${import.meta.env.BASE_URL}samples/`;
