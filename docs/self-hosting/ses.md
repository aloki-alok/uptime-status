# Amazon SES gates

Amazon SES transport and production delivery are not implemented. The repository has an in-memory subscriber state service, injectable subscribe and confirm routes, and provider-neutral mail rendering for deterministic tests. It does not provision SES resources, persist subscribers durably, send mail, process provider feedback, or deliver incident updates.

Keep both subscription acceptance and notification fanout disabled until every applicable gate below has passed in the site's selected AWS account and region.

## Configuration shape

The site schema accepts SES settings only when subscriptions are enabled:

```json
{
  "subscriptions": {
    "enabled": true,
    "doubleOptIn": true,
    "notificationFanoutEnabled": false,
    "delivery": {
      "provider": "ses",
      "region": "ap-south-1",
      "senderName": "Example status",
      "senderEmail": "status@example.com",
      "replyToEmail": "support@example.com",
      "contactListName": "example-status",
      "topicName": "service-updates"
    },
    "confirmationTtlSeconds": 86400,
    "resendCooldownSeconds": 300
  }
}
```

The schema, test state service, injectable routes, and provider-neutral renderer consume this shape today. No production repository, SES adapter, queue worker, or feedback processor is wired. Do not enable it on a public site until those paths and the gates below are verified.

## Gate 1: sender readiness

- Verify the sending domain or address in the configured region.
- Enable and validate DKIM.
- Configure and validate a custom MAIL FROM domain when required by the site's deliverability policy.
- Publish SPF and DMARC records appropriate to the sending domain.
- Confirm the configured sender and reply-to identities match site policy.

AWS reference: [Creating and verifying identities in Amazon SES](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html).

## Gate 2: subscriber safety

- Implement durable pending, active, unsubscribed, and suppressed states.
- Use double opt-in for every address.
- Return non-enumerating public responses.
- Verify confirmation expiry, resend cooldown, and one-click unsubscribe.
- Ensure logs never contain raw addresses, confirmation tokens, or unsubscribe material.
- Reconcile local suppression with the SES account-level suppression list.

AWS references: [Subscription management](https://docs.aws.amazon.com/ses/latest/dg/sending-email-subscription-management.html) and [account-level suppression](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html).

## Gate 3: feedback and failure handling

- Create the configured contact list and topic.
- Configure event publishing for delivery, bounce, complaint, rejection, and rendering failure outcomes.
- Prove hard bounces and complaints suppress later sends.
- Prove retries are bounded and ambiguous provider acknowledgements do not normally duplicate delivery.
- Prove the delivery kill switch stops queue consumption without deleting queued work.

AWS reference: [Add an event destination](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination.html).

## Gate 4: sandbox exit

- Request production access in the exact region used by the site.
- While the account remains in the SES sandbox, send only to verified canary recipients.
- Confirm the approved sending quota and rate are sufficient for the intended subscriber volume.

AWS reference: [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

## Gate 5: end-to-end canary

Trace subscribe, confirmation, activation, unsubscribe, hard bounce, complaint, suppression, retry, and kill-switch behavior. Confirm that a curated incident or maintenance revision is publicly visible before its related email is sent.

Only after this trace passes may an operator request separate approval to set `notificationFanoutEnabled` to true. Schema validation, a verified sender, or SES production access alone is not enough.
