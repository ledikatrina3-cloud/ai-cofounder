bashWhitelist: ["pnpm exec tsx skills/browser-control/scripts/healthcheck.ts"]
maxStepsPerInvocation: 10
healthCheck:
  script: scripts/healthcheck.ts
  schedule: "0 7 * * *"
