module.exports = (req, res) => {
  res.status(200).json({
    status: "success",
    message: "WeeBear Telegram Bot is operational",
    endpoints: {
      webhook: "/webhook",
      healthcheck: "/"
    }
  });
};
