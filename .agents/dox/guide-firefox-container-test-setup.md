# Firefox container fixture setup

This fixture serves synthetic pages on loopback port `48765`. It does not control Firefox or CTC.

WARNING: Export the current CTC rules to a private local backup before editing. Do not share the export or import it as replacement configuration.

## Setup

1. Start the fixture from the repository root with `node .agents/dox/test-firefox-container-server.mjs`.
2. Stop if the fixture reports that port `48765` is busy. Do not stop the existing listener.
3. Export the current CTC rules through its UI and save the backup privately.
4. Check existing rules for patterns that match any test path. Stop if a rule matches.
5. Create two new containers in Firefox: `FFX Test Work` and `FFX Test Personal`.
6. Refresh CTC's container list.
7. Add a restricted rule for `FFX Test Work` with pattern `127.0.0.1:48765/pi-firefox-test/work/`.
8. Add a restricted rule for `FFX Test Personal` with pattern `127.0.0.1:48765/pi-firefox-test/personal/`.
9. Add one restricted shared-route rule to each new container. Use pattern `127.0.0.1:48765/pi-firefox-test/shared/`.
10. Leave high priority off and leave all existing rules unchanged.
11. Click Save Rules in CTC.
12. Confirm CTC reports that the rules were saved.

CTC keeps the current container when that container matches a restricted rule. From the default container, the shared route selects the first matching rule in CTC order. From either test container, the shared route stays in that container. Do not infer a `cookieStoreId` from a container name.

Before any later agent page action, get user confirmation for the exact candidate tab and verify its actual container. The public CLI cannot create containers or change CTC settings.

The agent starts the fixture server when testing begins; it need not run during manual container setup.

## Later cookie test

Wait for separate approval before using cookie controls. The server sets one synthetic `pi_firefox_test` cookie only after a form POST.

11. Reset server-side comparison state from any fixture page.
12. Set the synthetic cookie on the Work route only.
13. Record cookie presence on the Work route.
14. Open the Personal route in `FFX Test Personal`.
15. Record cookie presence on the Personal route without setting its cookie.
16. Read the aggregate result. Expect `{"equal":false}`.
17. Clear the synthetic cookie in each test container.
18. Reset server-side comparison state.

The endpoint compares only cookie-presence booleans. It returns no cookie contents and stores no form text.

## Cleanup

19. Remove only the four temporary rules.
20. Remove only the two new test containers.
21. Stop the fixture with Ctrl-C.
22. Keep the original settings. Do not import the saved rules as a replacement.
