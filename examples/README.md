# Examples

Sample input for trying the workflows. `pnpm dev` allows this folder as a workspace root
(`AAP_WORKSPACE_ROOTS`) unless you set your own.

- `sample-app/`: a small customer search screen (React), written for this repository. Use
  it as the **Source directory** of the Generate Spec workflow, for example
  `<repo>/examples/sample-app`, with `<repo>/examples/specs` as the **Output directory**.

Generated specs land in `examples/specs/`, which Git ignores.

These files are input data, not part of the application: they are excluded from linting and
type checking.
