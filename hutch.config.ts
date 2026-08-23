export default {
  electrobun: { version: "2.0.1" },
  packageManager: "bun",
  scripts: {
    install: ["hutch", "pm", "install", "--frozen-lockfile"],
    prepare: ["hutch", "electrobun", "prepare"],
    dev: ["hutch", "electrobun", "dev", "--watch"],
    build: ["hutch", "electrobun", "build", "--env=canary"],
  },
};
