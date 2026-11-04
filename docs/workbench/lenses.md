# Lenses

All perspectives use self-side definitions with the same controls.

![Lens editor from an earlier Workbench version](../assets/workbench/lenses.png)

Choose **Create lens** to supply an ID, title and sensitivity categories. IDs match filenames and use lowercase kebab-case. Every definition has **Edit definition** and **Fine-tune instructions**. Instructions are stored inside the definition; there is no base-lens inheritance.

In **Spaces**, **Edit binding** selects a default and secondary lenses. Removing a binding prunes the project from the catalog and blocks linked retrieval until it is bound again. A bound definition cannot be removed. `private` stays exclusive to the direct owner and cannot be removed.

Edits require the current registry hash. Stale edits fail without replacing newer data. Each lens's `sensitivity_access` decides which sensitive categories it can read. The seeded `public-voice` lens grants all five configurable categories and has no extra publication filter, so it returns compensation details and unapproved evidence when a document grants it access; external publication remains a separate user action. See [lenses and privacy](../concepts/lenses-and-privacy.md).
