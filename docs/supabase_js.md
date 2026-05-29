# Supabase JS/Node.js Reference Guide

This document contains implementation patterns for integrating the **Supabase JavaScript SDK** with Node.js/Express.

---

## 1. Installation

```bash
npm install @supabase/supabase-js
```

---

## 2. Initializing Client

```javascript
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY; // or Service Role Key for admin overrides

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing Supabase Environment Variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
```

---

## 3. Basic Database Queries (CRUD)

### Reading Data
```javascript
const getMatches = async () => {
  const { data, error } = await supabase
    .from('matches')
    .select('id, team_a, team_b, status')
    .eq('status', 'LIVE')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data;
};
```

### Inserting Data
```javascript
const createMatch = async (matchDetails) => {
  const { data, error } = await supabase
    .from('matches')
    .insert([matchDetails])
    .select(); // Retrieves the newly created record

  if (error) throw error;
  return data[0];
};
```

### Updating Data
```javascript
const updateScore = async (matchId, runs, wickets) => {
  const { data, error } = await supabase
    .from('matches')
    .update({ runs, wickets })
    .eq('id', matchId)
    .select();

  if (error) throw error;
  return data[0];
};
```

### Deleting Data
```javascript
const deleteMatch = async (matchId) => {
  const { error } = await supabase
    .from('matches')
    .delete()
    .eq('id', matchId);

  if (error) throw error;
};
```

---

## 4. Query Filters & Pagination

### Operators
```javascript
// Greater than / Less than
const filterMatches = async (minRuns) => {
  const { data } = await supabase
    .from('matches')
    .select('*')
    .gt('runs', minRuns);
  return data;
};
```

### Pagination (Limit & Offset)
```javascript
const getPaginatedMatches = async (page = 1, pageSize = 10) => {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, count } = await supabase
    .from('matches')
    .select('*', { count: 'exact' })
    .range(from, to);

  return { data, total: count };
};
```

---

## 5. Middleware Auth Verification

To authenticate requests to Express routes using Supabase JWT tokens:

```javascript
const supabase = require('./supabaseClient');

const checkAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Unauthorized token' });
  }

  // Attach user object to request
  req.user = user;
  next();
};

module.exports = checkAuth;
```
