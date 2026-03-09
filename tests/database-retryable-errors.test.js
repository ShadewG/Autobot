const assert = require("assert");

const db = require("../services/database");

describe("database retryable errors", function () {
  it("treats Postgres too-many-clients saturation as retryable", function () {
    assert.strictEqual(
      db._isRetryableQueryError({
        code: "53300",
        message: "sorry, too many clients already",
      }),
      true
    );
  });

  it("treats connection acquisition timeouts as retryable and uses a slower backoff", function () {
    const error = {
      message: "Connection terminated due to connection timeout",
    };

    assert.strictEqual(db._isRetryableQueryError(error), true);
    assert.strictEqual(db._getRetryBackoffMs(error, 1), 1000);
  });
});
