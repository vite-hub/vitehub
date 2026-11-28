// The registry items are Vue SFCs. tsrs reads no `.vue` file, so the package's TypeScript sees each one as a component.
// `vp pack` builds their real types with vue-tsc, and `typecheck:registry` checks them.
declare module "*.vue" {
  import type { DefineComponent } from "vue";

  const component: DefineComponent;
  export default component;
}
