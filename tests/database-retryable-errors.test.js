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
});
