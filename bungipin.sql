CREATE DATABASE IF NOT EXISTS defaultdb;
USE defaultdb;

-- Drop Instances
DROP PROCEDURE IF EXISTS sp_get_all_patient_records;
DROP PROCEDURE IF EXISTS sp_get_patient_record;
DROP PROCEDURE IF EXISTS sp_get_employee_record;
DROP PROCEDURE IF EXISTS sp_register_user;
DROP TABLE IF EXISTS activity_logs;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS password_resets;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS xrays;
DROP TABLE IF EXISTS patient_documents;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS allergies;
DROP TABLE IF EXISTS prescriptions;
DROP TABLE IF EXISTS health_conditions;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS admin_profiles;
DROP TABLE IF EXISTS doctor_schedules;
DROP TABLE IF EXISTS employee_profiles;
DROP TABLE IF EXISTS patient_profiles;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    public_id       VARCHAR(10) UNIQUE,       
    first_name      VARCHAR(50)  NOT NULL,
    last_name       VARCHAR(50)  NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    password_hash   VARCHAR(255) NOT NULL,
    sex             VARCHAR(10),
    role            ENUM('patient','employee','admin') NOT NULL,
    account_status  ENUM('active','suspended') NOT NULL DEFAULT 'active',
    login_attempts  INT NOT NULL DEFAULT 0,
    is_locked       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE patient_profiles (
    patient_id       INT PRIMARY KEY,
    birthday         DATE,
    secondary_email  VARCHAR(150),
    address          VARCHAR(255),
    address_street   VARCHAR(150),
    address_barangay VARCHAR(100),
    address_city     VARCHAR(100),
    address_province VARCHAR(100),
    pregnancy_status VARCHAR(30),
    FOREIGN KEY (patient_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE employee_profiles (
    employee_id   INT PRIMARY KEY,
    staff_code    VARCHAR(30) UNIQUE,
    position      VARCHAR(30),
    birthday      DATE,
    FOREIGN KEY (employee_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE admin_profiles (
    admin_id          INT PRIMARY KEY,
    permission_level  VARCHAR(30),
    FOREIGN KEY (admin_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- Public ID Procedure
DELIMITER $$
CREATE PROCEDURE sp_register_user(
    IN p_first_name  VARCHAR(50),
    IN p_last_name   VARCHAR(50),
    IN p_email       VARCHAR(150),
    IN p_phone       VARCHAR(20),
    IN p_password_hash VARCHAR(255),
    IN p_sex         VARCHAR(10),
    IN p_role        ENUM('patient','employee','admin'),
    OUT p_new_user_id INT
)
BEGIN
    INSERT INTO users (first_name, last_name, email, phone, password_hash, sex, role)
    VALUES (p_first_name, p_last_name, p_email, p_phone, p_password_hash, p_sex, p_role);

    SET p_new_user_id = LAST_INSERT_ID();

    UPDATE users
    SET public_id = CONCAT(
        CASE p_role
            WHEN 'patient'  THEN 'PAT'
            WHEN 'employee' THEN 'EMP'
            WHEN 'admin'    THEN 'ADM'
            ELSE 'USR'
        END,
        '-', LPAD(p_new_user_id, 4, '0')
    )
    WHERE user_id = p_new_user_id;

    IF p_role = 'patient' THEN
        INSERT INTO patient_profiles (patient_id) VALUES (p_new_user_id);
    ELSEIF p_role = 'employee' THEN
        INSERT INTO employee_profiles (employee_id) VALUES (p_new_user_id);
    ELSEIF p_role = 'admin' THEN
        INSERT INTO admin_profiles (admin_id) VALUES (p_new_user_id);
    END IF;
END$$
DELIMITER ;

CREATE TABLE audit_logs (
    log_id        INT AUTO_INCREMENT PRIMARY KEY,
    admin_id      INT NOT NULL,
    action        VARCHAR(100) NOT NULL,
    target_table  VARCHAR(50)  NOT NULL,
    target_id     INT NOT NULL,
    notes         TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admin_profiles(admin_id) ON DELETE CASCADE
);

CREATE TABLE activity_logs (
    log_id        INT AUTO_INCREMENT PRIMARY KEY,
    user_id       INT NULL,
    user_email    VARCHAR(100) NULL,
    user_role     ENUM('admin','employee','patient','unregistered') NOT NULL DEFAULT 'unregistered',
    action        VARCHAR(80) NOT NULL,
    target_table  VARCHAR(60) NOT NULL DEFAULT 'system',
    target_id     INT NULL,
    notes         TEXT NULL,
    ip_address    VARCHAR(45) NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    -- SET NULL, not CASCADE: deleting a user should never erase the audit
    -- trail of what that user did. Every other FK in this schema cascades,
    -- but that pattern is wrong specifically for a log table.
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_created_at (created_at),
    INDEX idx_user_role (user_role),
    INDEX idx_action (action)
);

CREATE TABLE doctor_schedules (
    schedule_id   INT AUTO_INCREMENT PRIMARY KEY,
    employee_id   INT NOT NULL,
    day_of_week   TINYINT NOT NULL,          -- 0=Sunday ... 6=Saturday
    start_time    TIME NULL,
    end_time      TIME NULL,
    break_start   TIME NULL,
    break_end     TIME NULL,
    is_active     BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (employee_id) REFERENCES employee_profiles(employee_id) ON DELETE CASCADE,
    UNIQUE KEY unique_employee_day (employee_id, day_of_week)
);

CREATE TABLE health_conditions (
    condition_id  INT AUTO_INCREMENT PRIMARY KEY,
    patient_id    INT NOT NULL,
    description   VARCHAR(255) NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE prescriptions (
    prescription_id  INT AUTO_INCREMENT PRIMARY KEY,
    patient_id       INT NOT NULL,
    medication_name  VARCHAR(100) NOT NULL,
    dosage           VARCHAR(50),
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE allergies (
    allergy_id   INT AUTO_INCREMENT PRIMARY KEY,
    patient_id   INT NOT NULL,
    allergen     VARCHAR(100) NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE services (
    service_id        INT AUTO_INCREMENT PRIMARY KEY,
    label             VARCHAR(100) NOT NULL,
    price             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    duration_minutes  INT NOT NULL DEFAULT 30,
    icon              VARCHAR(255),
    is_available      BOOLEAN NOT NULL DEFAULT TRUE
);

-- ================= APPOINTMENTS =================
CREATE TABLE appointments (
    appointment_id      INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    employee_id         INT NULL,
    service_id          INT NOT NULL,
    appointment_date    DATE NOT NULL,
    time_slot           TIME NOT NULL,
    end_time            TIME NOT NULL,
    appointment_status  ENUM('pending','approved','completed','cancelled') NOT NULL DEFAULT 'pending',
    queue_status        ENUM('pending','waiting','ongoing','completed') NOT NULL DEFAULT 'pending',
    reschedule_status   ENUM('none','requested','approved','declined') NOT NULL DEFAULT 'none',
    requested_date      DATE NULL,
    requested_time      TIME NULL,
    reschedule_reason   VARCHAR(255) NULL,
    patient_note        VARCHAR(255) NULL,
    dentist_note        VARCHAR(255) NULL,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id)  REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employee_profiles(employee_id) ON DELETE SET NULL,
    FOREIGN KEY (service_id)  REFERENCES services(service_id) ON DELETE RESTRICT
);

CREATE TABLE payments (
    payment_id       INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id   INT NOT NULL UNIQUE,
    amount           DECIMAL(10,2) NOT NULL,
    payment_date     DATE,
    method           ENUM('cash','card','online') NOT NULL,
    status           ENUM('pending','paid','refunded') NOT NULL DEFAULT 'pending',
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE CASCADE
);

CREATE TABLE xrays (
    xray_id         INT AUTO_INCREMENT PRIMARY KEY,
    patient_id      INT NOT NULL,
    appointment_id  INT NULL,
    uploaded_by     INT NOT NULL,
    file_url        VARCHAR(255) NOT NULL,
    uploaded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id)     REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE SET NULL,
    FOREIGN KEY (uploaded_by)    REFERENCES employee_profiles(employee_id) ON DELETE RESTRICT
);

CREATE TABLE messages (
    message_id   INT AUTO_INCREMENT PRIMARY KEY,
    sender_id    INT NOT NULL,
    receiver_id  INT NOT NULL,
    content      TEXT,
    file_url     VARCHAR(255),
    sent_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_read      BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (sender_id)   REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE notifications (
    notification_id  INT AUTO_INCREMENT PRIMARY KEY,
    user_id          INT NOT NULL,
    type             VARCHAR(50) NOT NULL,
    title            VARCHAR(100) NOT NULL,
    message          TEXT,
    appointment_id   INT NULL,
    message_id       INT NULL,
    is_read          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)        REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    FOREIGN KEY (message_id)     REFERENCES messages(message_id) ON DELETE CASCADE,
    CONSTRAINT chk_single_source CHECK (
        NOT (appointment_id IS NOT NULL AND message_id IS NOT NULL)
    )
);

CREATE TABLE patient_documents (
    document_id   INT AUTO_INCREMENT PRIMARY KEY,
    patient_id    INT NOT NULL,
    file_url      VARCHAR(255) NOT NULL,
    uploaded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE password_resets (
    reset_id    INT PRIMARY KEY AUTO_INCREMENT,
    user_id     INT NOT NULL,
    token_hash  VARCHAR(64) NOT NULL,
    expires_at  DATETIME NOT NULL,
    used        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_token_hash (token_hash)
);

-- ================= PROCEDURES (WITH PATIENT_DOCUMENTS SUPPORT) =================
DELIMITER $$
CREATE PROCEDURE sp_get_patient_record(IN p_patient_id INT)
BEGIN
    SELECT JSON_OBJECT(
        'patient_id', pp.patient_id,
        'public_id', u.public_id,
        'first_name', u.first_name,
        'last_name', u.last_name,
        'sex', u.sex,
        'birthday', pp.birthday,
        'email', u.email,
        'phone', u.phone,
        'address', pp.address,
        'address_street', pp.address_street,
        'address_barangay', pp.address_barangay,
        'address_city', pp.address_city,
        'address_province', pp.address_province,
        'pregnancy_status', pp.pregnancy_status,
        'health_conditions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('description', description)), JSON_ARRAY())
            FROM health_conditions WHERE patient_id = pp.patient_id
        ),
        'allergies', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('allergen', allergen)), JSON_ARRAY())
            FROM allergies WHERE patient_id = pp.patient_id
        ),
        'prescriptions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('medication_name', medication_name, 'dosage', dosage)), JSON_ARRAY())
            FROM prescriptions WHERE patient_id = pp.patient_id
        ),
        'patient_documents', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('document_id', document_id, 'file_url', file_url, 'uploaded_at', uploaded_at)), JSON_ARRAY())
            FROM patient_documents WHERE patient_id = pp.patient_id
        ),
        'xrays', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('xray_id', xray_id, 'appointment_id', appointment_id, 'file_url', file_url)), JSON_ARRAY())
            FROM xrays WHERE patient_id = pp.patient_id
        ),
        'last_visit', (
            SELECT MAX(appointment_date) FROM appointments
            WHERE patient_id = pp.patient_id AND appointment_status = 'completed'
        ),
        'ongoing_appointment', (
            SELECT JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id
              AND a.appointment_status = 'approved'
              AND a.queue_status = 'ongoing'
              AND a.appointment_date = CURDATE()
            ORDER BY a.time_slot DESC
            LIMIT 1
        ),
        'past_appointments', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )), JSON_ARRAY())
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id AND a.appointment_status = 'completed'
        )
    ) AS patient_record
    FROM patient_profiles pp
    JOIN users u ON pp.patient_id = u.user_id
    WHERE pp.patient_id = p_patient_id;
END$$
DELIMITER ;

DELIMITER $$
CREATE PROCEDURE sp_get_all_patient_records()
BEGIN
    SELECT JSON_OBJECT(
        'patient_id', pp.patient_id,
        'public_id', u.public_id,
        'first_name', u.first_name,
        'last_name', u.last_name,
        'sex', u.sex,
        'birthday', pp.birthday,
        'email', u.email,
        'phone', u.phone,
        'address', pp.address,
        'address_street', pp.address_street,
        'address_barangay', pp.address_barangay,
        'address_city', pp.address_city,
        'address_province', pp.address_province,
        'pregnancy_status', pp.pregnancy_status,
        'health_conditions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('description', description)), JSON_ARRAY())
            FROM health_conditions WHERE patient_id = pp.patient_id
        ),
        'allergies', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('allergen', allergen)), JSON_ARRAY())
            FROM allergies WHERE patient_id = pp.patient_id
        ),
        'prescriptions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('medication_name', medication_name, 'dosage', dosage)), JSON_ARRAY())
            FROM prescriptions WHERE patient_id = pp.patient_id
        ),
        'patient_documents', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('document_id', document_id, 'file_url', file_url, 'uploaded_at', uploaded_at)), JSON_ARRAY())
            FROM patient_documents WHERE patient_id = pp.patient_id
        ),
        'xrays', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('xray_id', xray_id, 'appointment_id', appointment_id, 'file_url', file_url)), JSON_ARRAY())
            FROM xrays WHERE patient_id = pp.patient_id
        ),
        'last_visit', (
            SELECT MAX(appointment_date) FROM appointments
            WHERE patient_id = pp.patient_id AND appointment_status = 'completed'
        ),
        'ongoing_appointment', (
            SELECT JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id
              AND a.appointment_status = 'approved'
              AND a.queue_status = 'ongoing'
              AND a.appointment_date = CURDATE()
            ORDER BY a.time_slot DESC
            LIMIT 1
        ),
        'past_appointments', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )), JSON_ARRAY())
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id AND a.appointment_status = 'completed'
        )
    ) AS patient_record
    FROM patient_profiles pp
    JOIN users u ON pp.patient_id = u.user_id
    ORDER BY u.user_id;
END$$
DELIMITER ;

DELIMITER $$
CREATE PROCEDURE sp_get_employee_record(IN p_employee_id INT)
BEGIN
    SELECT JSON_OBJECT(
        'employee_id', ep.employee_id,
        'public_id', u.public_id,
        'staff_code', ep.staff_code,
        'position', ep.position,
        'first_name', u.first_name,
        'last_name', u.last_name,
        'sex', u.sex,
        'birthday', ep.birthday,
        'email', u.email,
        'phone', u.phone
    ) AS employee_record
    FROM employee_profiles ep
    JOIN users u ON ep.employee_id = u.user_id
    WHERE ep.employee_id = p_employee_id;
END$$
DELIMITER ;

-- ================= SEED DATA =================
CALL sp_register_user('Maria', 'Santos', 'maria.santos@example.com', '09171234567', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'F', 'patient', @uid1);
CALL sp_register_user('Juan', 'Dela Cruz', 'juan.delacruz@example.com', '09179876543', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'M', 'patient', @uid2);
CALL sp_register_user('Ramon', 'Cruz', 'ramon.cruz@example.com', '09201112222', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'M', 'employee', @uid3);
CALL sp_register_user('Liza', 'Tan', 'liza.tan@example.com', '09203334444', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'F', 'employee', @uid4);
CALL sp_register_user('Carla', 'Reyes', 'carla.reyes@example.com', '09051119999', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'F', 'admin', @uid5);

UPDATE patient_profiles SET birthday = '1990-04-12', address = '123 Mabini St, Quezon City', address_street = '123 Mabini St', address_city = 'Quezon City', address_province = 'Metro Manila' WHERE patient_id = 1;
UPDATE patient_profiles SET birthday = '1985-11-02', address = '45 Rizal Ave, Manila', address_street = '45 Rizal Ave', address_city = 'Manila', address_province = 'Metro Manila' WHERE patient_id = 2;

UPDATE employee_profiles SET staff_code = 'STF-2026-001', position = 'Dentist', birthday = '1985-06-10' WHERE employee_id = 3;
UPDATE employee_profiles SET staff_code = 'STF-2026-002', position = 'Dentist', birthday = '1990-02-20' WHERE employee_id = 4;

UPDATE admin_profiles SET permission_level = 'full_access' WHERE admin_id = 5;

INSERT INTO services (label, price, duration_minutes, icon, is_available) VALUES
('Dental Cleaning', 1500.00, 45, 'cleaning-icon', TRUE),
('Pasta', 2500.00, 30, 'pasta-icon', TRUE),
('Checkup', 500.00, 30, 'checkup-icon', TRUE),
('Whitening', 3000.00, 60, 'whitening-icon', TRUE);

INSERT INTO appointments (patient_id, employee_id, service_id, appointment_date, time_slot, end_time, appointment_status, queue_status, reschedule_status, patient_note) VALUES
(1, 3, 1, '2026-09-10', '10:00:00', '10:45:00', 'approved', 'completed', 'none', 'First-time patient'),
(2, NULL, 2, '2026-09-12', '11:00:00', '11:30:00', 'pending', 'pending', 'none', NULL);

INSERT INTO payments (appointment_id, amount, payment_date, method, status) VALUES
(1, 1500.00, '2026-09-10', 'card', 'paid');

INSERT INTO xrays (patient_id, appointment_id, uploaded_by, file_url) VALUES
(1, 1, 3, '/xrays/patient1_visit1.png');

INSERT INTO messages (sender_id, receiver_id, content, is_read) VALUES
(3, 1, 'Please arrive 10 minutes early for your cleaning.', FALSE);

INSERT INTO notifications (user_id, type, title, message, appointment_id) VALUES
(1, 'appointment_status', 'Appointment Approved', 'Your appointment on 2026-09-10 has been approved.', 1);

INSERT INTO doctor_schedules (employee_id, day_of_week, start_time, end_time, break_start, break_end, is_active) VALUES
(4, 0, NULL, NULL, NULL, NULL, 0),
(4, 1, '08:00:00', '17:00:00', '12:00:00', '13:00:00', 1),
(4, 2, '08:00:00', '17:00:00', '12:00:00', '13:00:00', 1),
(4, 3, '08:00:00', '17:00:00', '12:00:00', '13:00:00', 1),
(4, 4, '08:00:00', '17:00:00', '12:00:00', '13:00:00', 1),
(4, 5, '08:00:00', '17:00:00', '12:00:00', '13:00:00', 1),
(4, 6, '08:00:00', '17:00:00', '12:00:00', '13:00:00', 1);

CALL sp_register_user(
    'Maria', 'Gomez', 'maria.gomez@example.com', '09171112223',
    '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi',
    'F', 'employee', @uid6
);
 
UPDATE employee_profiles SET staff_code = 'STF-2026-003', position = 'Dentist', birthday = '1988-09-03' WHERE employee_id = @uid6;

INSERT INTO doctor_schedules (employee_id, day_of_week, start_time, end_time, break_start, break_end, is_active) VALUES
(@uid6, 0, NULL, NULL, NULL, NULL, FALSE),
(@uid6, 1, '08:00:00', '17:00:00', '12:00:00', '13:00:00', TRUE),
(@uid6, 2, '08:00:00', '17:00:00', '12:00:00', '13:00:00', TRUE),
(@uid6, 3, '08:00:00', '17:00:00', '12:00:00', '13:00:00', TRUE),
(@uid6, 4, '08:00:00', '17:00:00', '12:00:00', '13:00:00', TRUE),
(@uid6, 5, '08:00:00', '17:00:00', '12:00:00', '13:00:00', TRUE),
(@uid6, 6, '08:00:00', '12:00:00', NULL, NULL, TRUE);

SELECT user_id, public_id, email, role, account_status, is_locked, login_attempts
FROM users
WHERE is_locked = 1
   OR login_attempts > 0
ORDER BY login_attempts DESC;

