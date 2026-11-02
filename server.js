const express = require('express');
const pool = require('./db/pool');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Store is running');
});

app.get('/test-db', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.id, p.name, p.price, c.name AS category
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = TRUE
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});