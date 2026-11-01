# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

1. Preferred: use GitHub's private vulnerability reporting. Go to the repository's **Security** tab and choose
   **Report a vulnerability**.
2. Fallback: email nuno_armada@hotmail.com with a description, reproduction steps and the affected version.

You will get an acknowledgement as soon as possible, and we will coordinate a fix and disclosure with you.

## Supported versions

Only the **latest minor release** receives security fixes. Please upgrade before reporting, if you can.

## Scope

In scope: the Arfolio application (web and worker), the Helm chart in `deploy/helm`, and the Docker Compose
setup (`compose.yaml`).

Arfolio is **self-hosted software**. There is no hosted service, so there is no central instance to report
against. Misconfiguration of your own deployment (weak secrets, exposed database, missing TLS) is out of scope,
but documentation gaps that lead to it are welcome reports.
