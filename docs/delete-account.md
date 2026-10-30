# Delete your Agora account

> **Draft, not yet published.** The public copy belongs at `https://agora.host/delete-account`. That URL goes in Play Console → App content → Data safety → the account deletion link. Contact: `<privacy contact address>`, the same as the [privacy policy](privacy-policy.md).

Agora is self-hosted. Your account lives on **the Agora server you signed up on**, which is run by its operator: you, your team, or whoever gave you its address. Caffeinated Software makes the Agora apps but does not run those servers and can't reach accounts on them.

## Delete your account

You can do this in the app or in any web browser:

1. Open your Agora server and sign in. In a browser, go to the address you add in the app, such as `https://agora.example.com`.
2. Go to **Settings → Account & security**.
3. Under **Delete account**, select **Delete account…** and confirm.

The page shows what happens to your messages before you confirm. Depending on the server's settings, they are either removed or kept without your name. Your username, email address, password, passkeys, settings and the server's record of your phones are deleted. The full list is in [what account deletion removes](account-deletion.md).

**Can't sign in?** Ask the operator of that server. Only they can delete an account you can't reach.

## Notification records on our push relay

If you used the Agora app with notifications turned on, our push relay holds your phone's push token and the server's address, encrypted. It holds no name or email. To remove those records:

- **Sign out** in the app, or **remove the server** from the app's server list. Either deletes the relay record at once.
- Or **uninstall the app**. The record is deleted the next time that server tries to notify you.

Records that go unused for 365 days are deleted automatically.

## The demo server

Caffeinated Software runs the demo server we give app reviewers. To delete an account there, use the steps above, or write to `<privacy contact address>`.

## More

- [Privacy policy](privacy-policy.md): what the apps, the relay and the servers keep.
