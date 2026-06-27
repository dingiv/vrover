# @vrover/visual-rover-cli

The one-shot **CLI frontend** for the VRover GUI agent (the "brain"). Wires config → LLM
provider → Platform → (optional) native OmniParser → the `runAgent` observe→think→act loop,
then prints the result and exits.

## Usage

```bash
pnpm rover:cli -- --task "click the login button"          # mock platform (default)
pnpm rover:cli -- --platform mock --provider glm --task "log in"
pnpm rover:cli -- --platform remote --scout-port 9000       # drive a Visual Scout server
pnpm rover:desktop                                          # = rover:cli --platform desktop
pnpm rover:cli -- --platform desktop --yolo-path weights/icon_detect.onnx
```

Without `--task` it prompts on a TTY, or reads the task from stdin. See `--help` for all flags.

The web frontend lives in `@vrover/visual-rover-web`.
