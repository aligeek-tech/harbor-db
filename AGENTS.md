# Release workflow

The project owner wants completed fixes published by default. After implementing and validating a fix, increment the patch version, update download links and release documentation, commit and push the changes, and publish a new tagged release through the existing GitHub Actions workflow. Verify that all platform installers are public and their checksums match before reporting publication as complete.

When a fix addresses a GitHub issue, close that issue as completed after the release is published and verified. Do not replace an already published tag or its binary assets; use a new version for subsequent fixes. Follow any more specific user instruction for the current task.
