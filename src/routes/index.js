// src/routes/index.js
const express = require('express');
const router = express.Router();
const fs = require("fs");
const path = require("path");
const imageController = require('../controllers/imageController');

router.get('/image', imageController.imageProxy);
router.get('/undefined', (req, res) => {
    res.json({ msg: "?" });
});
module.exports = router;
