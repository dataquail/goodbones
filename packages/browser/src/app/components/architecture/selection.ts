// What the Architecture Browser can hold: a file or folder of the tree, or a
// node of the manifest. In the hash as the path, or `node:<id>`.
export type Selection =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "folder"; readonly path: string }
  | { readonly kind: "node"; readonly id: string };
