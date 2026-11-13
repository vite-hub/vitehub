// Pierre's patch parsers, in a module of their own: a page that only renders a diff does not load them.
export { getSingularPatch, parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
