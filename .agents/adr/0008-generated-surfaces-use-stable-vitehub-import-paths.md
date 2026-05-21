# Generated Surfaces Use Stable ViteHub Import Paths

Application code imports generated or integration-backed ViteHub surfaces through stable `#vitehub/...` import paths. Framework virtual modules, generated file paths, and provider-output module ids are integration details unless an ADR explicitly makes one public.

This is a breaking public API cleanup: migrations from public virtual modules to stable ViteHub import paths do not keep compatibility aliases or legacy import surfaces. The trade-off is deliberate because keeping old virtual-module paths public would preserve framework details as app API and weaken the import boundary this decision creates.
