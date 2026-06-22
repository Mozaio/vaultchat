// libsodium-wrappers-sumo ships no own type declarations. We use it only via a
// lazy dynamic import in discoveryOprf.ts, accessed as `any`, so a loose ambient
// module declaration is enough to keep the strict NodeNext tsc build green.
declare module "libsodium-wrappers-sumo";
